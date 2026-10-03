CLASS zcl_bench_15 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_s_contact,
        first_name TYPE string,
        last_name  TYPE string,
        email      TYPE string,
      END OF ty_s_contact.
    DATA contacts        TYPE STANDARD TABLE OF ty_s_contact WITH EMPTY KEY.
    DATA draft           TYPE ty_s_contact.
    DATA last_name_state TYPE string.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS popup_display.
    METHODS model_init.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_15 IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      model_init( ).
      view_display( ).
    ELSEIF client->check_on_navigated( ).
      view_display( ).
    ELSEIF client->check_on_event( ).
      on_event( ).
    ENDIF.

  ENDMETHOD.

  METHOD view_display.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `View` ns = `mvc`
            )->a( n = `xmlns`        v = `sap.m`
            )->a( n = `xmlns:mvc`    v = `sap.ui.core.mvc`
            )->a( n = `displayBlock` v = `true`
            )->a( n = `height`       v = `100%` ).

    DATA(page) = view->ele( `Shell`
        )->ele( `Page`
            )->a( n = `title` v = `Contacts` ).

    DATA(table) = page->ele( `Table`
        )->a( n = `items` v = client->_bind( contacts ) ).

    table->ele( `headerToolbar`
        )->ele( `OverflowToolbar`
            )->tag( `ToolbarSpacer`
            )->tag( `Button`
                )->a( n = `text`  v = `Add contact`
                )->a( n = `icon`  v = `sap-icon://add`
                )->a( n = `press` v = client->_event( `ADD` ) ).

    table->ele( `columns`
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `First name`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Last name`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Email` ).

    table->ele( `items`
        )->ele( `ColumnListItem`
            )->ele( `cells`

                )->tag( `Text`
                    )->a( n = `text` v = `{FIRST_NAME}`
                )->tag( `Text`
                    )->a( n = `text` v = `{LAST_NAME}`
                )->tag( `Text`
                    )->a( n = `text` v = `{EMAIL}` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `ADD`.
        draft           = VALUE #( ).
        last_name_state = `None`.
        popup_display( ).
      WHEN `SAVE`.
        IF condense( draft-last_name ) IS INITIAL.
          last_name_state = `Error`.
        ELSE.
          APPEND draft TO contacts.
          client->popup_destroy( ).
        ENDIF.
    ENDCASE.

  ENDMETHOD.

  METHOD popup_display.

    DATA(fragment) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `FragmentDefinition` ns = `core`
            )->a( n = `xmlns`      v = `sap.m`
            )->a( n = `xmlns:core` v = `sap.ui.core`
            )->a( n = `xmlns:form` v = `sap.ui.layout.form` ).

    DATA(dialog) = fragment->ele( `Dialog`
        )->a( n = `title` v = `New contact` ).

    dialog->ele( n = `SimpleForm` ns = `form`
        )->a( n = `editable` v = `true`

        )->ele( n = `content` ns = `form`

            )->tag( `Label`
                )->a( n = `text` v = `First name`
            )->tag( `Input`
                )->a( n = `value` v = client->_bind( draft-first_name )
            )->tag( `Label`
                )->a( n = `text`     v = `Last name`
                )->a( n = `required` v = `true`
            )->tag( `Input`
                )->a( n = `value`          v = client->_bind( draft-last_name )
                )->a( n = `valueState`     v = client->_bind( last_name_state )
                )->a( n = `valueStateText` v = `Enter a last name`
            )->tag( `Label`
                )->a( n = `text` v = `Email`
            )->tag( `Input`
                )->a( n = `value` v = client->_bind( draft-email )
                )->a( n = `type`  v = `Email` ).

    dialog->ele( `beginButton`
        )->tag( `Button`
            )->a( n = `text`  v = `Save`
            )->a( n = `type`  v = `Emphasized`
            )->a( n = `press` v = client->_event( `SAVE` ) ).

    dialog->ele( `endButton`
        )->tag( `Button`
            )->a( n = `text`  v = `Cancel`
            )->a( n = `press` v = client->follow_up_action( z2ui5_if_client=>cs_event-popup_close ) ).

    client->popup_display( fragment->stringify( ) ).

  ENDMETHOD.

  METHOD model_init.

    contacts = VALUE #( ( first_name = `Anna`  last_name = `Schmidt` email = `anna.schmidt@example.com` )
                        ( first_name = `Peter` last_name = `Jones`   email = `peter.jones@example.com` ) ).

  ENDMETHOD.

ENDCLASS.
