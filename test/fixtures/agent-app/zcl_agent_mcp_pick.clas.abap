CLASS zcl_agent_mcp_pick DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_item,
        title TYPE string,
        descr TYPE string,
        selkz TYPE abap_bool,
      END OF ty_item.
    TYPES:
      BEGIN OF ty_msg,
        type  TYPE string,
        title TYPE string,
      END OF ty_msg.
    DATA name   TYPE string.
    DATA result TYPE string.
    DATA items  TYPE STANDARD TABLE OF ty_item WITH EMPTY KEY.
    DATA msgs   TYPE STANDARD TABLE OF ty_msg WITH EMPTY KEY.
  PRIVATE SECTION.
    DATA all TYPE STANDARD TABLE OF ty_item WITH EMPTY KEY.
    METHODS display
      IMPORTING
        client TYPE REF TO z2ui5_if_client.
    METHODS value_help
      IMPORTING
        client TYPE REF TO z2ui5_if_client.
ENDCLASS.

CLASS zcl_agent_mcp_pick IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    IF client->check_on_init( ).
      all = VALUE #( ( title = `alpha` descr = `first` ) ( title = `beta` descr = `second` ) ( title = `gamma` descr = `third` ) ).
      msgs = VALUE #( ( type = `Warning` title = `pick a customer` ) ).
      result = `nothing picked`.
      display( client ).
    ELSEIF client->check_on_event( `VH` ).
      items = all.
      value_help( client ).
    ELSEIF client->check_on_event( `SEARCH` ).
      DATA(query) = client->get_event_arg( 1 ).
      items = all.
      DELETE items WHERE title NS query.
      client->popup_model_update( ).
    ELSEIF client->check_on_event( `PICKED` ).
      name = client->get_event_arg( 1 ).
      result = |picked { name }|.
      LOOP AT items INTO DATA(item) WHERE selkz = abap_true.
        result = |{ result } selected { item-title }|.
      ENDLOOP.
      msgs = VALUE #( ( type = `Success` title = result ) ).
      client->popup_destroy( ).
      display( client ).
    ELSEIF client->check_on_event( `CANCEL` ).
      client->popup_destroy( ).
    ENDIF.
  ENDMETHOD.

  METHOD display.
    DATA(page) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `View` ns = `mvc`
            )->a( n = `xmlns`     v = `sap.m`
            )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
            )->ele( `Page`
                )->a( n = `title` v = `Pick test app` ).

    page->tag( `Label`
        )->a( n = `text`     v = `Customer`
        )->a( n = `labelFor` v = `customer`
        )->tag( `Input`
            )->a( n = `id`               v = `customer`
            )->a( n = `value`            v = client->_bind( name )
            )->a( n = `showValueHelp`    b = abap_true
            )->a( n = `valueHelpRequest` v = client->_event( `VH` )
        )->tag( `Text`
            )->a( n = `text` v = client->_bind( result ) ).

    page->ele( `dependents`
        )->ele( `MessagePopover`
            )->a( n = `items` v = client->_bind( msgs )
            )->tag( `MessageItem`
                )->a( n = `type`  v = `{TYPE}`
                )->a( n = `title` v = `{TITLE}` ).

    client->view_display( page->stringify( ) ).
  ENDMETHOD.

  METHOD value_help.
    DATA(dialog) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `FragmentDefinition` ns = `core`
            )->a( n = `xmlns`      v = `sap.m`
            )->a( n = `xmlns:core` v = `sap.ui.core`
            )->ele( `SelectDialog`
                )->a( n = `title`   v = `Customers`
                )->a( n = `items`   v = client->_bind( items )
                )->a( n = `search`  v = client->_event( val   = `SEARCH`
                                                        t_arg = VALUE #( ( `${$parameters>/value}` ) ) )
                )->a( n = `confirm` v = client->_event( val   = `PICKED`
                                                        t_arg = VALUE #( ( `${$parameters>/selectedItem}.getTitle()` ) ) )
                )->a( n = `cancel`  v = client->_event( `CANCEL` ) ).
    dialog->tag( `StandardListItem`
        )->a( n = `title`       v = `{TITLE}`
        )->a( n = `description` v = `{DESCR}`
        )->a( n = `selected`    v = `{SELKZ}` ).
    client->popup_display( dialog->stringify( ) ).
  ENDMETHOD.
ENDCLASS.
