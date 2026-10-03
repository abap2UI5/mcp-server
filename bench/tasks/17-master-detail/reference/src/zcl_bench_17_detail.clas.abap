CLASS zcl_bench_17_detail DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA id    TYPE string.
    DATA name  TYPE string.
    DATA city  TYPE string.
    DATA phone TYPE string.
    METHODS constructor
      IMPORTING
        id    TYPE string OPTIONAL
        name  TYPE string OPTIONAL
        city  TYPE string OPTIONAL
        phone TYPE string OPTIONAL.
    METHODS was_saved
      RETURNING
        VALUE(result) TYPE abap_bool.

  PROTECTED SECTION.
    DATA saved  TYPE abap_bool.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_17_detail IMPLEMENTATION.

  METHOD constructor.

    me->id    = id.
    me->name  = name.
    me->city  = city.
    me->phone = phone.

  ENDMETHOD.

  METHOD was_saved.
    result = saved.
  ENDMETHOD.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_navigated( ).
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
            )->a( n = `xmlns:form`   v = `sap.ui.layout.form`
            )->a( n = `displayBlock` v = `true`
            )->a( n = `height`       v = `100%` ).

    DATA(page) = view->ele( `Shell`
        )->ele( `Page`
            )->a( n = `title`          t = name
            )->a( n = `showNavButton`  v = `true`
            )->a( n = `navButtonPress` v = client->_event_nav_app_leave( ) ).

    page->ele( n = `SimpleForm` ns = `form`
        )->a( n = `editable` v = `true`

        )->ele( n = `content` ns = `form`

            )->tag( `Label`
                )->a( n = `text` v = `Number`
            )->tag( `Text`
                )->a( n = `text` v = client->_bind( id )
            )->tag( `Label`
                )->a( n = `text` v = `Name`
            )->tag( `Text`
                )->a( n = `text` v = client->_bind( name )
            )->tag( `Label`
                )->a( n = `text` v = `City`
            )->tag( `Text`
                )->a( n = `text` v = client->_bind( city )
            )->tag( `Label`
                )->a( n = `text` v = `Phone`
            )->tag( `Input`
                )->a( n = `value` v = client->_bind( phone )
                )->a( n = `type`  v = `Tel` ).

    page->ele( `footer`
        )->ele( `OverflowToolbar`
            )->tag( `ToolbarSpacer`
            )->tag( `Button`
                )->a( n = `text`  v = `Save`
                )->a( n = `type`  v = `Emphasized`
                )->a( n = `press` v = client->_event( `SAVE` ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `SAVE`.
        saved = abap_true.
        client->nav_app_leave( ).
    ENDCASE.

  ENDMETHOD.

ENDCLASS.
